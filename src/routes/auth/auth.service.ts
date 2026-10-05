// routes/auth/auth.service.ts
import { ObjectId } from "mongodb";
import { IUserPatch, IUserResponse } from "./auth.types";
import { IProfile } from "../../@types/collections/users/profile";
import { Database } from "../../middlewares/database/mongodb";
import checkObjectId from "../../middlewares/helpers/checkObjectId";

export async function createUser(user: IProfile): Promise<IUserResponse> {
  try {
    const userResponse = await Database.Users.Profiles().insertOne(user);
    return {
      status: 200,
      data: {
        user: { ...user, _id: userResponse.insertedId },
      },
    };
  } catch (err: any) {
    // Duplicate key on the unique username index (race with userExists)
    if (err?.code === 11000) {
      return { status: 409, data: { user: null } };
    }
    return { status: 501, data: { user: null } };
  }
}

export async function userExists(username: string): Promise<IUserResponse> {
  const user = await Database.Users.Profiles().findOne({ username });
  if (user) {
    return {
      status: 200,
      data: { user },
    };
  }
  return {
    status: 404,
    data: { user: null },
  };
}

export async function findAllUsers(): Promise<IProfile[]> {
  return await Database.Users.Profiles().find({}).sort({ createdAt: 1 }).toArray();
}

export async function countUsers(): Promise<number> {
  return await Database.Users.Profiles().countDocuments({});
}

export async function findById(userId: string | ObjectId): Promise<IUserResponse> {
  if (typeof userId === "string" && !checkObjectId(userId)) {
    return { status: 404, data: { user: null } };
  }

  const user = await Database.Users.Profiles().findOne({
    _id: new ObjectId(userId),
  });
  if (user) {
    return {
      status: 200,
      data: { user },
    };
  }
  return {
    status: 404,
    data: { user: null },
  };
}

export async function updateUserLastSession(id: ObjectId): Promise<IProfile | null> {
  return await Database.Users.Profiles().findOneAndUpdate(
    { _id: id },
    { $set: { lastSession: new Date() } },
    { returnDocument: "after" }
  );
}

/**
 * Patch update for ADMIN user management.
 * Controller is responsible for authorization and for sanitizing payload.
 */
export async function updateUserById(
  userId: string | ObjectId,
  patch: IUserPatch
): Promise<IUserResponse> {
  if (typeof userId === "string" && !checkObjectId(userId)) {
    return { status: 404, data: { user: null } };
  }

  const $set: Partial<IProfile> = { updatedAt: new Date() };

  if (typeof patch.email === "string") $set.email = patch.email;
  if (typeof patch.displayName === "string") $set.displayName = patch.displayName;
  if (typeof patch.status === "string") $set.status = patch.status;

  const user = await Database.Users.Profiles().findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set },
    { returnDocument: "after" }
  );

  if (!user) {
    return { status: 404, data: { user: null } };
  }

  return { status: 200, data: { user } };
}

export async function updateUserPassword(
  userId: ObjectId,
  passwordHash: string
): Promise<boolean> {
  const result = await Database.Users.Profiles().updateOne(
    { _id: userId },
    { $set: { password: passwordHash, updatedAt: new Date() } }
  );
  return result.matchedCount === 1;
}
