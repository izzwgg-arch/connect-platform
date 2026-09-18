import { useCallback, useEffect, useState } from "react";
import { SafeAreaView, ScrollView } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { PostDTO } from "../../api/types";
import { Empty, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";
import { PostCard } from "./PostCard";

type Props = NativeStackScreenProps<HomeStackParamList, "PostDetail">;

export function PostDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [post, setPost] = useState<PostDTO | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    api<{ post: PostDTO }>(`/posts/${id}`)
      .then((r) => setPost(r.post))
      .catch((err) => {
        if ((err as ApiError).status === 404) setNotFound(true);
        else toast((err as ApiError).message, { kind: "err" });
      });
  }, [id]);

  useEffect(load, [load]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {notFound ? (
          <Empty icon="brief" title="This post isn't available" hint="It may have been removed, or you may not have permission to see it." />
        ) : post ? (
          <PostCard
            item={post}
            onChange={setPost}
            onOpenProfile={(username) => navigation.navigate("PersonProfile", { username })}
            onOpenOrg={(slug) => navigation.navigate("Company", { slug })}
          />
        ) : (
          <Skeleton height={160} radius={16} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
