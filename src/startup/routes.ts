import express, { Application } from 'express';
import cors from 'cors';
import { router as api } from '../routes/api.routes';

function corsOrigins(): string[] {
    return (process.env.CORS_ORIGIN ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
}

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
