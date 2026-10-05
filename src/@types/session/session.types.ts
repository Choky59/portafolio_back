import { ServiceResponse } from "../../constants/serviceResponse";
import { ISession } from "../collections/users/session";

export interface IUserAuthentication {
    username: string;
    password: string;
    expiration?: number;
}

export interface ICreateSession extends ServiceResponse {
    data?: {
        session: ISession;
        token: string;
    };
}

export interface IEndSession extends ServiceResponse {
    data?: { ended: number };
}

export interface IActiveSessions extends ServiceResponse {
    data?: ISession[]
}
