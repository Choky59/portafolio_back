import { ObjectId } from "mongodb"

export default (id: string) => {
    return typeof id === "string" && ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
}
