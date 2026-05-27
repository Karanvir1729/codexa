declare module "lucide-react/dist/esm/icons/*.js" {
  import type { FC, SVGProps } from "react";

  const Icon: FC<SVGProps<SVGSVGElement> & { size?: number | string }>;
  export default Icon;
}
