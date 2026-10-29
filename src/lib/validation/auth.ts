import { z } from "zod";

export const loginSchema = z.object({
  email: z
    .string("Enter your email address.")
    .trim()
    .min(1, "Enter your email address.")
    .max(320, "Enter a valid email address.")
    .pipe(z.email("Enter a valid email address.")),
  // Passwords are not trimmed or otherwise altered.
  password: z
    .string("Enter your password.")
    .min(1, "Enter your password.")
    .max(1024, "Password is too long."),
});

export type LoginInput = z.infer<typeof loginSchema>;
