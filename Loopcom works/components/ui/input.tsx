import * as React from "react"

import { cn } from "@/lib/utils"
import { handleNumberInputWheel } from "@/lib/ui/prevent-number-input-wheel-change"
import { handleCalculatorEnterKey } from "@/lib/ui/numeric-calculator"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * Enable calculator mode: type 100+50 then Enter to commit 150.
   * Expressions that start with an operator (+10, -5) are left unchanged.
   * Uses text + decimal keypad so operators can be typed.
   */
  calculator?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, onKeyDown, onChange, value, calculator, inputMode, ...props }, ref) => {
    const resolvedType = calculator ? "text" : type
    const resolvedInputMode = calculator ? (inputMode ?? "decimal") : inputMode

    return (
      <input
        type={resolvedType}
        inputMode={resolvedInputMode}
        className={cn(
          "flex h-11 min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        value={value}
        onChange={onChange}
        onWheel={(e) => {
          if (resolvedType === "number" || calculator) {
            handleNumberInputWheel(e)
          }
          onWheel?.(e)
        }}
        onKeyDown={(e) => {
          if (calculator) {
            handleCalculatorEnterKey(e, String(value ?? ""), (next) => {
              onChange?.({
                target: { value: next },
                currentTarget: { value: next },
              } as React.ChangeEvent<HTMLInputElement>)
            })
          }
          onKeyDown?.(e)
        }}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
