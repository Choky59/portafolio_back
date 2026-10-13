import { IDevice } from "../../@types/collections/devices/device";
import { BATERIA_BAJA_PCT } from "../../constants/devices";

/** Never send secret or claim code hashes to the client */
export function sanitizeDevice(device: IDevice | null) {
  if (!device) return null;
  const { secretHash, claimCodeHash, ...safeDevice } = device;
  return {
    ...safeDevice,
    // Same low-battery rule as the dashboard, so the panel doesn't duplicate the threshold
    bateria: device.bateria
      ? { ...device.bateria, baja: device.bateria.porcentaje < BATERIA_BAJA_PCT }
      : null,
    hasPendingClaim:
      !!claimCodeHash &&
      !!device.claimCodeExpiresAt &&
      device.claimCodeExpiresAt.getTime() > Date.now(),
  };
}
