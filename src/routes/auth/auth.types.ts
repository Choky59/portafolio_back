import { ServiceResponse } from "../../constants/serviceResponse";
import { IProfile, UserStatus } from "../../@types/collections/users/profile";

export interface IUserResponse extends ServiceResponse {
  data: {
    user: IProfile | null;
  };
}

export interface IUserData {
  username: string;
  email: string;
  displayName: string;
  password: string;
}

export interface IUserPatch {
  email?: string;
  displayName?: string;
  status?: UserStatus;
}

export interface IChangePassword {
  currentPassword: string;
  newPassword: string;
}
