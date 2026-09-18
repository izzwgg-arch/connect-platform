import React from 'react'
import { ViewProps } from 'react-native'
import { AppScreen } from './AppScreen'

export function Screen({ style, children }: ViewProps) {
  return <AppScreen style={style}>{children}</AppScreen>
}

