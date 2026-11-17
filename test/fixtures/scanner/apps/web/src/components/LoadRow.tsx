import { useEffect } from "react";
import { useGetLoadQuery } from "../api";

export function LoadRow({ id, refetch }: any) {
  const { data } = useGetLoadQuery(id, { pollingInterval: 10000 });
  useEffect(() => {
    const t = setInterval(() => refetch(), 5000);
    return () => clearInterval(t);
  }, []);
  return <tr><td>{data?.status}</td></tr>;
}
