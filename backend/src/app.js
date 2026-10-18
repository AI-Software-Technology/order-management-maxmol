const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const apiRouter = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

const origins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(
  cors({
    origin: origins.includes('*') ? true : origins,
    credentials: true,
  })
);
// 25mb: product images / payment proofs are sent as base64 strings
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

app.get('/', (_req, res) => res.json({ name: 'Maxmol Lubricant Lubricant ERP API', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api', apiRouter);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
