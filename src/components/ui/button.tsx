import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Site Rep keeps its looks in src/styles.css recipes (context-dependent, e.g.
 * ".lead-form button"), so the base recipe is intentionally EMPTY: a plain
 * native <button> that recipes and className style, matching DESIGN.md
 * ("Components"). Variants are opt-in token-level looks for new screens.
 * `type` defaults to "submit" to preserve the native button semantics the app
 * relies on (Base UI would otherwise force type="button").
 */
const buttonVariants = cva("", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground",
      outline: "border border-border bg-background text-foreground",
      secondary: "bg-secondary text-secondary-foreground",
      ghost: "text-foreground",
      destructive: "bg-destructive/10 text-destructive",
      link: "text-primary underline-offset-4 hover:underline",
    },
    size: {
      default: "gap-1.5 px-2.5",
      xs: "gap-1 px-2 text-xs",
      sm: "gap-1 px-2.5 text-[0.8rem]",
      lg: "gap-1.5 px-3",
      icon: "p-2",
    },
  },
  defaultVariants: {
    variant: null,
    size: null,
  },
})

function Button({
  className,
  variant,
  size,
  type = "submit",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
