import { comparePassword, encryptPassword } from "../../middlewares/auth/encryption"
import { ISession } from "../../@types/collections/users/session";
import { IUserAuthentication } from "../../@types/session/session.types";
import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";
import * as AuthService from "../auth/auth.service";
import * as SessionService from "./session.service";
import { sanitizeUser } from "../auth/helpers.misc";

/** bcrypt hash used to spend the same time when the user doesn't exist */
let dummyHash: Promise<string> | null = null
function getDummyHash(): Promise<string> {
    if (!dummyHash) dummyHash = encryptPassword("dummy-password-for-timing")
    return dummyHash
}

/** Never expose tokenHash */
function sanitizeSession(session: ISession, currentId?: string) {
    const { tokenHash, ...safeSession } = session
    return { ...safeSession, current: session._id?.toString() === currentId }
}

export async function authenticate(req: Request, res: Response): Promise<Response> {
    const { username, password, expiration } = req.body as IUserAuthentication
    const userResponse = await AuthService.userExists(username)
    const user = userResponse.data.user

    // Same response (and similar timing) for unknown user, wrong password or inactive user (no user enumeration)
    const validPassword = await comparePassword(password, user?.password ?? await getDummyHash())
    if (!user?._id || !validPassword || user.status !== "ACTIVE") {
        return sendErrorResponse(res, 401, {
            key: "INVALID_CREDENTIALS",
            message: "Invalid username or password",
        })
    }

    const sessionCreated = await SessionService.createSession(user._id, expiration)

    if (sessionCreated.status != 200 || !sessionCreated.data) {
        return sendErrorResponse(res, sessionCreated.status)
    }

    const updatedUser = await AuthService.updateUserLastSession(user._id)
    const { session, token } = sessionCreated.data

    return sendSuccessResponse(res, 200, {
        user: sanitizeUser(updatedUser ?? user),
        session: {
            token,
            created: session.created,
            expiration: session.expiration,
        },
    })
}

export async function endSession(req: Request, res: Response): Promise<Response> {
    const session = req.body.session as ISession
    const closeAll = req.body.closeAll as boolean

    if (closeAll == true) {
        const endSessionResponse = await SessionService.endAllUserSessions(session.userId);
        return sendSuccessResponse(res, 200, {
            message: "Ended all user sessions",
            ended: endSessionResponse.data?.ended ?? 0,
        })
    }

    const endSessionResponse = await SessionService.endSession(session._id!);

    if (endSessionResponse.status != 200) {
        return sendErrorResponse(res, endSessionResponse.status)
    }

    return sendSuccessResponse(res, 200, { message: "Session ended" })
}

export async function getActiveSessions(req: Request, res: Response): Promise<Response> {
    const session = req.body.session as ISession
    const userSessionResponse = await SessionService.getAllUserSessions(session.userId);

    const currentId = session._id?.toString()
    return sendSuccessResponse(res, 200, {
        sessions: (userSessionResponse.data ?? []).map((s) => sanitizeSession(s, currentId)),
    })
}
