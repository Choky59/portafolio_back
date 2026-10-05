import { Response } from "express";

interface ErrorStructure {
    [code: number]: {
        status: number,
        message: string,
    }
}

interface ErrorResponse {
    status: number,
    message: string,
    response?: any
}

export function sendErrorResponse(res: Response, code: number, data?: any): Response {
    let response: ErrorResponse = ERROR_STATUS_RESPONSES[code];
    if (data) {
        return res.status(code).send({
            error: data
        })
    }
    return res.status(code).send(response);
}

const ERROR_STATUS_RESPONSES: ErrorStructure = {
    400: {
        status: 400,
        message: "Required params are missing or invalid",
    },
    401: {
        status: 401,
        message: "Unauthorized access",
    },
    403: {
        status: 403,
        message: "Forbidden",
    },
    404: {
        status: 404,
        message: "Not found",
    },
    409: {
        status: 409,
        message: "Conflict",
    },
    429: {
        status: 429,
        message: "Too many requests",
    },
    500: {
        status: 500,
        message: "Internal Server Error",
    },
    501: {
        status: 501,
        message: "Database error",
    },
}
