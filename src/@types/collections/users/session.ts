import { ObjectId } from "mongodb";

export interface ISession {
    _id?: ObjectId;
    userId: ObjectId;
    /** sha256 of the session token. The raw token is only returned on login. */
    tokenHash: string;
    created: Date;
    expiration: Date;
}
