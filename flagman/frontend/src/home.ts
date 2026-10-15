import type { Role } from "./types";

/** Стартовый экран по роли (п. 31): каждый сразу видит свою работу. */
export const HOME: Record<Role, string> = {
  ADMIN: "dashboard",
  MANAGER: "dashboard",
  CASHIER: "pos",
  COOK: "kitchen",
  STOREKEEPER: "acceptance",
};
