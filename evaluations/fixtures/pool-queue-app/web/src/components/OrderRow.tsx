import { useGetOrderStatusQuery } from "../api";

export function OrderRow({ id }: { id: number }) {
  const { data } = useGetOrderStatusQuery(id, { pollingInterval: 15000 });
  return <tr><td>{id}</td><td>{data?.status}</td></tr>;
}
