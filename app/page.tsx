import type { Metadata } from "next";
import { FiveApp } from "./FiveApp";

export const metadata: Metadata = {
  title: "FIVE — Your next $5, handled",
  description:
    "Choose a payout destination and preview how a transparent micro-earning agent would work.",
};

export default function Home() {
  return <FiveApp />;
}
