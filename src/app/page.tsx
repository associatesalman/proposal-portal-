import { redirect } from "next/navigation";

// The portal has no landing page: go to the dashboard (the proxy sends
// signed-out visitors to /login first).
export default function Home() {
  redirect("/dashboard");
}
