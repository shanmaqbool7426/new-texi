import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server } from 'socket.io';

import cors from 'cors';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import compression from 'compression';
import passengerRoutes from './passenger/route.js';
import driverRoutes from './driver/route.js';
import vehicleRoutes from './vehicle/route.js';
// import { authPassenger } from './middleware/authMiddleware.js';
import { connectDB } from './utils/mongoDB.js';
import Ride from './ride/model.js'
import Driver from './driver/model.js'
import Passenger from './passenger/model.js'
import http from "http"
dotenv.config();

const app = express();

// Set security HTTP headers
app.use(helmet());
connectDB()
// Enable CORS
const whitelist = ['https://riding-app-backend.vercel.app',"http://localhost:3000", 'https://dev-kyoopay-be.rtdemo.com', 'http://localhost:3001', 'https://dev-kyoopay-admin.rtdemo.com'];
const corsOptions = {
  "/": {
    origin: ["http://localhost:3001", "http://localhost:3000",'https://riding-app-backend.vercel.app'], // Allowed origins for the /user route
    credentials: true, // Allow credentials (cookies, authorization headers, etc.)
  },
  origin: function (origin, callback) {
    if (!origin || whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));

// Limit requests from same API
const limiter = rateLimit({
  max: 100, // 100 requests per hour
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'Too many requests from this IP, please try again later!'
});
app.use('/api', limiter);

// Body parser, reading data from body into req.body
app.use(express.json({ limit: '10kb' }));

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Data sanitization against XSS
app.use(xss());

// Compress responses
app.use(compression());

// Development logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use('/api/v1/passenger', passengerRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/vehicles', vehicleRoutes);
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
// Protect routes that require authentication
// app.use('/api/passenger/profile', passengerRoutes);

app.use((err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  res.status(err.statusCode).json({
    status: err.status,
    message: err.message
  });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3001', 'http://localhost:3000', 'https://0a8c-39-45-24-33.ngrok-free.app','https://riding-app-backend.vercel.app'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  }
});
app.set("io", io)
const drivers = {};
const passengers = {};

// const registerDriver = (socket, driverId) => {
//   drivers[driverId] = socket;
// };

// const registerPassenger = (socket, passengerId) => {
//   passengers[passengerId] = socket;
// };

const emitSocketEvent = (userId, event, payload) => {
  console.log('Emitting event:', event, 'to user:', userId, 'with payload:', payload);
  io.to(userId).emit(event, payload);
};

const handleRideRequest = async (socket, { passengerId, pickupLocation, dropoffLocation, fare }) => {
  const newRide = new Ride({
    passenger: passengerId,
    pickupLocation,
    dropoffLocation,
    fare,
    status: 'requested',
  });

  const savedRide = await newRide.save();

  const nearbyDrivers = await Driver.find({
    location: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: pickupLocation.coordinates,
        },
        $maxDistance: 10000, // 10 km radius
      },
    },
    availability: true,
  });

  nearbyDrivers.forEach((driver) => {
      emitSocketEvent(driver._id, 'rideRequest', savedRide);
  });

  emitSocketEvent(passengerId, 'rideRequested', savedRide);
};

const handleAcceptRide = async (socket, { rideId, driverId }) => {
  const ride = await Ride.findById(rideId);
  if (ride) {
    ride.status = 'accepted';
    ride.driver = driverId;
    const updatedRide = await ride.save();
    emitSocketEvent(ride.passenger, 'rideAccepted', updatedRide);
    emitSocketEvent(driverId, 'rideAccepted', updatedRide);
  }
};

const handleConfirmRide = async (socket, { rideId, driverId }) => {
  const ride = await Ride.findById(rideId);
  if (ride) {
    ride.status = 'completed';
    ride.driver = driverId;
    const updatedRide = await ride.save();
    emitSocketEvent(ride.passenger, 'rideCompleted', updatedRide);
    emitSocketEvent(driverId, 'rideCompleted', updatedRide);
  }
};

const handleCancelRide = async (socket, { rideId }) => {
  const ride = await Ride.findById(rideId);
  if (ride) {
    ride.status = 'cancelled';
    const updatedRide = await ride.save();
    emitSocketEvent(ride.passenger, 'rideCancelled', updatedRide);
  }
};

const initializeSocketIO = (io) => {
  return io.on('connection', async (socket) => {
    try {
      const authToken = socket.handshake.headers?.authorization;
      const decodedToken = await jwt.verify(authToken, process.env.TOKEN_SECRET);
      const userId = decodedToken._id.toString();
      socket.join(userId);

      console.log('A user connected:', userId);
      socket.emit('connection', 'Connected successfully');

      // socket.on('registerDriver', (driverId) => {
      //   registerDriver(socket, driverId);
      // });

      // socket.on('registerPassenger', (passengerId) => {
      //   registerPassenger(socket, passengerId);
      // });

      socket.on('rideRequest', (data) => handleRideRequest(socket, data));
      socket.on('acceptRide', (data) => handleAcceptRide(socket, data));
      socket.on('confirmRide', (data) => handleConfirmRide(socket, data));
      socket.on('cancelRide', (data) => handleCancelRide(socket, data));

      socket.on('disconnect', () => {
        console.log('A user disconnected:', userId);
        delete drivers[userId];
        delete passengers[userId];
      });

    } catch (error) {
      console.error('Authentication error:', error.message);
      socket.disconnect();
    }
  });
};
initializeSocketIO(io)
