import { IProfile } from "../../@types/collections/users/profile";

/** Never send password hashes to the client */
export function sanitizeUser(user: IProfile | null) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}
