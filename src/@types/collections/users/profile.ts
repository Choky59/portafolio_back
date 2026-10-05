import { ObjectId } from "mongodb";

export type UserRole = "ADMIN";
export type UserStatus = "ACTIVE" | "INACTIVE";

export interface IProfile {
  _id?: ObjectId;

  username: string;
  email: string;
  displayName: string;

  /** bcrypt hash */
  password: string;

  role: UserRole;
  status: UserStatus;
  lastSession: Date | null;

  createdAt: Date;
  updatedAt: Date;
}
