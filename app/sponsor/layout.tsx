import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./sponsor.css";

export const metadata: Metadata = {
  title: "Sponsor a task",
  description:
    "Fund a bounded, automation-approved task for FIVE and track its funding status.",
};

export default function SponsorLayout({ children }: { children: ReactNode }) {
  return children;
}
