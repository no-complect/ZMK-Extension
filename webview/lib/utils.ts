import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes safely — resolves conflicts in favour of the last class. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
