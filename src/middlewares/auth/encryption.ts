import { compare, hash } from "bcrypt";

const SALT_ROUNDS = 10;

export function encryptPassword(password: string): Promise<string> {
    return hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hashedPassword: string): Promise<boolean> {
    try {
        return await compare(password, hashedPassword);
    } catch {
        return false;
    }
}
