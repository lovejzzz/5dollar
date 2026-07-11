import type { Metadata } from "next";
import { FiveApp } from "./FiveApp";

export const metadata: Metadata = {
  title: "FIVE — Your next $5 gift card, handled",
  description:
    "Enter an email and preview how a transparent agent can earn and deliver a $5 digital gift card.",
};

export default function Home() {
  return <FiveApp />;
}
