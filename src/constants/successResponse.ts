import { Response } from "express";

export function sendSuccessResponse(res: Response, code: number, data: any): Response {
    return res.status(code).send({
        ...data,
        status: code
    });
}
