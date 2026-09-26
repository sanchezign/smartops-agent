"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/features/auth/api";
import { useApiQuery } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import type { AlertItem, Availability, CatalogSupplier, ProductDetail, ProductRow } from "./types";

export const useCatalogSuppliers = () =>
  useApiQuery<{ suppliers: CatalogSupplier[] }>(
    ["catalog", "suppliers"],
    "/admin/catalog/suppliers",
  );

export function useProducts(filter: {
  supplierId: string | null;
  q: string;
  availability: Availability;
}) {
  return useInfiniteQuery({
    queryKey: ["catalog", "products", filter],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ availability: filter.availability, limit: "50" });
      if (filter.supplierId) params.set("supplierId", filter.supplierId);
      if (filter.q) params.set("q", filter.q);
      if (pageParam) params.set("cursor", pageParam);
      return api.request<{ items: ProductRow[]; nextCursor: string | null }>(
        `/admin/catalog/products?${params.toString()}`,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export const useProduct = (id: string) =>
  useApiQuery<{ product: ProductDetail }>(
    ["catalog", "product", id],
    `/admin/catalog/products/${id}`,
  );

export function useRenameSupplier(onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api.request<{ supplier: { name: string; changed: boolean } }>(
        `/admin/catalog/suppliers/${input.id}`,
        { method: "PATCH", body: JSON.stringify({ name: input.name }) },
      ),
    onSuccess: (data) => {
      toast.success(data.supplier.changed ? "Proveedor renombrado." : "El nombre ya era ese.");
      onDone();
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.code === "CONFLICT"
          ? "Ya hay otro proveedor con ese nombre. (Unir proveedores llega más adelante.)"
          : "No se pudo renombrar.",
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    },
  });
}

export const useAlerts = (status: "open" | "all") =>
  useApiQuery<{ open: number; items: AlertItem[] }>(
    ["alerts", status],
    `/admin/alerts?status=${status}`,
  );

export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request<{ changed: boolean }>(`/admin/alerts/${id}/acknowledge`, { method: "POST" }),
    onError: () => toast.error("No se pudo marcar como vista."),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
