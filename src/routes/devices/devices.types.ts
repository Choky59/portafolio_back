import { ServiceResponse } from "../../constants/serviceResponse";
import { IDevice } from "../../@types/collections/devices/device";
import { DeviceStatus, DeviceType } from "../../constants/devices";

export interface IDeviceResponse extends ServiceResponse {
  data: {
    device: IDevice | null;
  };
}

export interface IDeviceCreate {
  name: string;
  type: DeviceType;
  description?: string;
  proyecto?: string | null;
}

export interface IDevicePatch {
  name?: string;
  type?: DeviceType;
  description?: string | null;
  proyecto?: string | null;
}

export interface IDeviceFilter {
  type?: DeviceType;
  status?: DeviceStatus;
  proyecto?: string;
}

export interface IDeviceClaim {
  claimCode: string;
  hardwareId?: string;
  firmwareVersion?: string;
}
