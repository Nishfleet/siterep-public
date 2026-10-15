import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

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
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      type={type}
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  )
}

export { Button, buttonVariants }
