declare module "lucide-react/dist/esm/icons/*.js" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  export interface LucideProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
    absoluteStrokeWidth?: boolean;
    color?: string;
    size?: number | string;
    strokeWidth?: number | string;
  }

  export type LucideIcon = ForwardRefExoticComponent<
    LucideProps & RefAttributes<SVGSVGElement>
  >;

  const Icon: LucideIcon;
  export default Icon;
}
