import { Database } from "../database/mongodb";
import { IProfile } from "../../@types/collections/users/profile";
import { ISession } from "../../@types/collections/users/session";
import { ObjectId } from "mongodb";
import { ServiceResponse } from "../../constants/serviceResponse";
import { hashToken } from "../auth/tokens";

interface IFindUserSession extends ServiceResponse {
    data?: ISession | null;
}

export async function findUserSession(token: string): Promise<IFindUserSession> {
    const session = await Database.Users.Sessions().findOne({
        tokenHash: hashToken(token),
        expiration: { $gt: new Date() },
    })
    if (session) {
        return {
            status: 200,
            data: session
        }
    }
    return {
        status: 401
    }
}

interface IFindUserData extends ServiceResponse {
    data?: IProfile | null
}

export async function findUser(userId: ObjectId): Promise<IFindUserData> {
    const user = await Database.Users.Profiles().findOne({ _id: userId })
    if (user) {
        return {
            status: 200,
            data: user
        }
    }
    return {
        status: 404
    }
}
