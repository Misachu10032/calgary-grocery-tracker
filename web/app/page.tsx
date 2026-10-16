import { getSiteData } from "@/lib/data";
import { PriceBrowser } from "./components/PriceBrowser";

// Built once from Supabase (cached with `use cache`), then served statically.
// The weekly collector triggers a rebuild via a deploy hook to refresh prices.
export default async function Home() {
  const data = await getSiteData();
  return <PriceBrowser data={data} />;
}
