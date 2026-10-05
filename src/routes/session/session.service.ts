import { ObjectId } from "mongodb";
import { ISession } from "../../@types/collections/users/session";
import { IActiveSessions, ICreateSession, IEndSession } from "../../@types/session/session.types";
import { Database } from "../../middlewares/database/mongodb";
import { generateToken, hashToken } from "../../middlewares/auth/tokens";

const MILLIS_IN_DAY = 86400000;

export function expirationFromType(expirationType: number | undefined, from = Date.now()): Date {
    switch (expirationType) {
        case 0: // 1 hr
            return new Date(from + MILLIS_IN_DAY / 24)
        case 2: // 7 days
            return new Date(from + MILLIS_IN_DAY * 7)
        case 3: // 30 days
            return new Date(from + MILLIS_IN_DAY * 30)
        case 1: // 24 hr
        default:
            return new Date(from + MILLIS_IN_DAY)
    }
}

export async function createSession(userId: ObjectId, expirationType?: number): Promise<ICreateSession> {
    const token = generateToken()
    const session: ISession = {
        userId,
        tokenHash: hashToken(token),
        created: new Date(),
        expiration: expirationFromType(expirationType),
    }

    const sessionData = await Database.Users.Sessions().insertOne(session)

    if (sessionData.acknowledged != true) {
        return { status: 501 }
    }
    return {
        status: 200,
        data: {
            session: { ...session, _id: sessionData.insertedId },
            token,
        },
    }
}

export async function endSession(sessionId: ObjectId): Promise<IEndSession> {
    const result = await Database.Users.Sessions().deleteOne({ _id: sessionId })
    if (result.deletedCount == 0) {
        return { status: 404 }
    }
    return { status: 200, data: { ended: result.deletedCount } }
}

/** Ends every session of the user, optionally keeping one (e.g. the current one) */
export async function endAllUserSessions(userId: ObjectId, exceptSessionId?: ObjectId): Promise<IEndSession> {
    const filter: any = { userId }
    if (exceptSessionId) filter._id = { $ne: exceptSessionId }

    const result = await Database.Users.Sessions().deleteMany(filter)
    return { status: 200, data: { ended: result.deletedCount } }
}

export async function getAllUserSessions(userId: ObjectId): Promise<IActiveSessions> {
    const sessions = await Database.Users.Sessions()
        .find({ userId, expiration: { $gt: new Date() } })
        .sort({ created: -1 })
        .toArray()

    return { status: 200, data: sessions }
}
