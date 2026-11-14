/** A chat provider and one of its models. */
export interface ModelSelection {
  provider: string
  model: string
}

/**
 * Chooses the model of a call that sends images of the screen.
 *
 * The owner can name a stronger model for these calls. Without a complete choice, or when its provider is not
 * configured, the call uses the model of the card, so that the character still sees the screen.
 *
 * @example
 * modelForScreen({ provider: 'a', model: 'cheap' }, { provider: 'b', model: 'strong' }, () => true)
 * // => { provider: 'b', model: 'strong' }
 */
export function modelForScreen(card: ModelSelection, screen: ModelSelection, isConfigured: (provider: string) => boolean): ModelSelection {
  if (!screen.provider || !screen.model)
    return card
  if (!isConfigured(screen.provider)) {
    console.warn(`[perception] The screen model uses the provider "${screen.provider}", which is not configured. The turn uses the model of the card.`)
    return card
  }
  return screen
}
