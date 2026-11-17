import { useEffect, useState } from "react";

export function Carousel({ slides }: any) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % slides.length), 4000);
    return () => clearInterval(t);
  }, []);
  return <div>{slides[i]}</div>;
}
