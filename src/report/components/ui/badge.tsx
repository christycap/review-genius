import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
    "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground",
                secondary: "bg-secondary text-secondary-foreground",
                outline: "border-border text-foreground",
                ghost: "text-muted-foreground"
            }
        },
        defaultVariants: {
            variant: "default"
        }
    }
);

function Badge({
    className,
    variant = "default",
    asChild = false,
    ...props
}: React.ComponentProps<"span"> &
    VariantProps<typeof badgeVariants> & {
        asChild?: boolean;
    }) {
    const Component = asChild ? Slot.Root : "span";

    return (
        <Component
            data-slot="badge"
            data-variant={variant}
            className={cn(badgeVariants({ variant }), className)}
            {...props}
        />
    );
}

export { Badge, badgeVariants };
