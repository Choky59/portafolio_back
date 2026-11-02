import express, { Application } from 'express';
import cors from 'cors';
import { router as api } from '../routes/api.routes';
import { corsOrigins } from './cors';

export { corsOrigins };

export function startRoutes(app: Application): void {
    console.debug('Creating routes')
    app.use(express.json({ limit: '1mb' }))
    app.use(cors({
        origin: corsOrigins(),
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'session'],
    }));
    app.use('/api', api)
}
