import { IDevice } from "../../@types/collections/devices/device";

/** Never send secret or claim code hashes to the client */
export function sanitizeDevice(device: IDevice | null) {
  if (!device) return null;
  const { secretHash, claimCodeHash, ...safeDevice } = device;
  return {
    ...safeDevice,
    hasPendingClaim:
      !!claimCodeHash &&
      !!device.claimCodeExpiresAt &&
      device.claimCodeExpiresAt.getTime() > Date.now(),
  };
}
