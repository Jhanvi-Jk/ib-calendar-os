import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/data/queries";

export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? "/calendar" : "/login");
}
