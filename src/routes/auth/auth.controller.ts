// routes/auth/auth.controller.ts
import { Request, Response } from "express";

import { comparePassword, encryptPassword } from "../../middlewares/auth/encryption";

import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";

import { IProfile } from "../../@types/collections/users/profile";
import { ISession } from "../../@types/collections/users/session";

import { IChangePassword, IUserData, IUserPatch } from "./auth.types";
import * as AuthService from "./auth.service";
import * as SessionService from "../session/session.service";
import { sanitizeUser } from "./helpers.misc";

/**
 * GET /auth/me
 * User was already loaded by sessionValidation (res.locals.user)
 */
export async function getMe(_req: Request, res: Response): Promise<Response> {
  const user = res.locals.user as IProfile;
  return sendSuccessResponse(res, 200, { user: sanitizeUser(user) });
}

/**
 * PATCH /auth/me/password
 * Requires the current password and ends every other session of the user.
 */
export async function changePassword(req: Request, res: Response): Promise<Response> {
  const user = res.locals.user as IProfile;
  const session = req.body.session as ISession;
  const { currentPassword, newPassword } = req.body as IChangePassword;

  const validPassword = await comparePassword(currentPassword, user.password);
  if (!validPassword) {
    return sendErrorResponse(res, 401, {
      key: "INVALID_CREDENTIALS",
      message: "Current password is incorrect",
    });
  }

  const passwordHash = await encryptPassword(newPassword);
  const updated = await AuthService.updateUserPassword(user._id!, passwordHash);
  if (!updated) {
    return sendErrorResponse(res, 501, {
      key: "USER_UPDATE_FAILED",
      message: "Failed to update password",
    });
  }

  await SessionService.endAllUserSessions(user._id!, session._id);

  return sendSuccessResponse(res, 200, { message: "Password updated" });
}

export async function getUsers(_req: Request, res: Response): Promise<Response> {
  const users = await AuthService.findAllUsers();
  return sendSuccessResponse(res, 200, { users: users.map(sanitizeUser) });
}

/**
 * POST /auth/users
 * ADMIN creates another ADMIN
 */
export async function createUser(req: Request, res: Response): Promise<Response> {
  const user = req.body as IUserData;

  const userResponse = await AuthService.userExists(user.username);
  if (userResponse.status === 200) {
    return sendErrorResponse(res, 409, {
      key: "USER_ALREADY_EXISTS",
      message: "A user with that username already exists",
      username: user.username,
    });
  }

  const now = new Date();
  const userData: IProfile = {
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    password: await encryptPassword(user.password),
    role: "ADMIN",
    status: "ACTIVE",
    lastSession: null,
    createdAt: now,
    updatedAt: now,
  };

  const userCreated = await AuthService.createUser(userData);
  if (userCreated.status !== 200) {
    return sendErrorResponse(res, userCreated.status, {
      key: userCreated.status === 409 ? "USER_ALREADY_EXISTS" : "USER_CREATE_FAILED",
      message: "Failed to create user",
    });
  }

  return sendSuccessResponse(res, 201, {
    user: sanitizeUser(userCreated.data.user),
  });
}

/**
 * PATCH /auth/users/:userId
 */
export async function updateUser(req: Request, res: Response): Promise<Response> {
  const requester = res.locals.user as IProfile;
  const targetUserId = req.params.userId as string;
  const body = req.body as IUserPatch;

  const patch: IUserPatch = {};
  if (typeof body.email === "string") patch.email = body.email;
  if (typeof body.displayName === "string") patch.displayName = body.displayName;
  if (typeof body.status === "string") patch.status = body.status;

  // Avoid locking yourself out
  if (patch.status === "INACTIVE" && requester._id?.toString() === targetUserId) {
    return sendErrorResponse(res, 400, {
      key: "CANNOT_DEACTIVATE_SELF",
      message: "You cannot deactivate your own user",
    });
  }

  const updated = await AuthService.updateUserById(targetUserId, patch);
  if (updated.status !== 200 || !updated.data.user) {
    return sendErrorResponse(res, 404, {
      key: "USER_NOT_FOUND",
      message: "Target user not found",
      userId: targetUserId,
    });
  }

  if (patch.status === "INACTIVE") {
    await SessionService.endAllUserSessions(updated.data.user._id!);
  }

  return sendSuccessResponse(res, 200, { user: sanitizeUser(updated.data.user) });
}
