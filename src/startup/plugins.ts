import { Application, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { sendErrorResponse } from '../constants/errorResponse';

/** Must be applied BEFORE routes so headers are set on every response */
export function security(app: Application): void {
    app.use(helmet())
    app.use(compression())
}

/** Must be applied AFTER routes */
export function errorHandlers(app: Application): void {
    app.use((_req: Request, res: Response) => {
        sendErrorResponse(res, 404, { key: 'NOT_FOUND', message: 'Route not found' })
    })

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        // Malformed JSON body
        if (err?.type === 'entity.parse.failed') {
            sendErrorResponse(res, 400, { key: 'INVALID_JSON', message: 'Malformed JSON body' })
            return
        }
        console.error(err)
        sendErrorResponse(res, 500)
    })
}
