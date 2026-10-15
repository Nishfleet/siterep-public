import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

/*
 * Site Rep keeps its looks in src/styles.css recipes, so this is a plain
 * native <input> with a data-slot (DESIGN.md, "Components"): recipes and
 * className style it. No preset utilities, so context CSS owns every pixel.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={className}
      {...props}
    />
  )
}

export { Input }
