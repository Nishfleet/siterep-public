import * as React from "react"

/*
 * Site Rep keeps its looks in src/styles.css recipes, so this is a plain
 * native <textarea> with a data-slot (DESIGN.md, "Components"): recipes and
 * className style it. No preset utilities, so context CSS owns every pixel.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={className}
      {...props}
    />
  )
}

export { Textarea }
