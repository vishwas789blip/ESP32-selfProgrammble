import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';

import { authRoutes } from './routes/authRoutes.js';
import { deviceRoutes } from './routes/deviceRoutes.js';
import { sensorRoutes } from './routes/sensorRoutes.js';
import { actuatorRoutes } from './routes/actuatorRoutes.js';
import { automationRoutes } from './routes/automationRoutes.js';
import { eventRoutes } from './routes/eventRoutes.js';
import { aiRoutes } from './routes/aiRoutes.js';

import { errorMiddleware } from './middleware/errorMiddleware.js';
import { notFoundMiddleware } from './middleware/notFoundMiddleware.js';

export const app = express();


// ================= CORS =================

app.use(cors({
  origin: 'https://esp32-iot-platform.vercel.app',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));


// ================= MIDDLEWARE =================

app.use(helmet());

app.use(express.json({
  limit: '100kb',
}));

app.use(
  morgan(
    env.NODE_ENV === 'production'
      ? 'combined'
      : 'dev'
  )
);


// ================= HEALTH =================

app.get('/', (_req, res) => {
  res.json({
    name: 'ESP32 Self-Programmable API',
    version: '1.0.0',
    status: 'running',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'esp32-self-programmable-backend',
    },
  });
});


// ================= ROUTES =================

app.use('/api/auth', authRoutes);

app.use('/api/devices', deviceRoutes);

app.use('/api', sensorRoutes);

app.use('/api', actuatorRoutes);

app.use('/api/automations', automationRoutes);

app.use('/api/events', eventRoutes);

app.use('/api/ai', aiRoutes);


// ================= ERRORS =================

app.use(notFoundMiddleware);

app.use(errorMiddleware);