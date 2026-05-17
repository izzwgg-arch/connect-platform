"use client";

import { Suspense } from "react";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { SolaImportsWorkspace } from "../_components/adminBillingSolaImportsWorkspace";

export default function AdminBillingSolaImportsPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <SolaImportsWorkspace />
    </Suspense>
  );
}
