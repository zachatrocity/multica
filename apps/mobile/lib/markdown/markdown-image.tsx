/**
 * Block-level image with authenticated loading, real aspect ratio, visible
 * failure recovery, and tap-to-lightbox.
 *
 *   - Rendering uses `expo-image` for on-disk caching + smooth fade-in.
 *   - The image's load event supplies its intrinsic dimensions, avoiding a
 *     second network request solely to calculate aspect ratio.
 *   - While loading (and after failure) the slot stays at a compact 16:9.
 *   - A failed load becomes a labelled retry action rather than a permanent
 *     empty placeholder.
 *
 * URI resolution: markdown content authored in Multica may use the internal
 * `mc://file/<id>` scheme or the stable authenticated attachment path. The
 * request helper resolves those references, adds the bearer token only for
 * this API's URLs, and deliberately keeps signed CDN/external URLs anonymous.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { Attachment } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { api } from "@/data/api";
import { useT } from "@/lib/i18n";
import { buildMarkdownImageRequest } from "./markdown-image-request";
import { useLightbox } from "./lightbox-provider";
import { useImageSequence } from "./image-sequence";

interface Props {
  uri: string;
  alt?: string;
  attachments?: Attachment[];
}

type LoadState = "loading" | "loaded" | "error";

export function MarkdownImage({ uri, alt, attachments }: Props) {
  const { open } = useLightbox();
  const sequence = useImageSequence();
  const { t } = useT("issues");
  const token = api.getToken();
  const [aspect, setAspect] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [retryNonce, setRetryNonce] = useState(0);

  const request = useMemo(
    () => buildMarkdownImageRequest(uri, attachments, token),
    [uri, attachments, token],
  );

  useEffect(() => {
    setAspect(null);
    setLoadState("loading");
  }, [request]);

  const handlePress = () => {
    if (loadState === "error") {
      setLoadState("loading");
      setRetryNonce((value) => value + 1);
      return;
    }
    open(request.uri, sequence);
  };

  return (
    <Pressable
      accessibilityRole={loadState === "error" ? "button" : "imagebutton"}
      accessibilityLabel={
        loadState === "error" ? t("image.retry_a11y") : alt || t("image.open_a11y")
      }
      onPress={handlePress}
    >
      <View
        className="rounded-lg overflow-hidden bg-muted"
        style={{ width: "100%", aspectRatio: aspect ?? 16 / 9 }}
      >
        <ExpoImage
          key={retryNonce}
          source={request}
          style={{ width: "100%", height: "100%" }}
          contentFit="contain"
          transition={150}
          recyclingKey={`${request.uri}:${retryNonce}`}
          onLoad={({ source }) => {
            if (source.width > 0 && source.height > 0) {
              setAspect(source.width / source.height);
            }
            setLoadState("loaded");
          }}
          onError={() => setLoadState("error")}
        />
        {loadState === "error" ? (
          <View className="absolute inset-0 items-center justify-center gap-1 bg-muted px-4">
            <Text className="text-center text-sm text-muted-foreground">
              {t("image.load_error")}
            </Text>
            <Text className="text-sm font-medium text-primary">
              {t("image.retry")}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
