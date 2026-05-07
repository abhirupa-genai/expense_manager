import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
    async signIn({ account, profile }) {
      if (account?.provider === "google") {
        return !!(
          profile?.email_verified &&
          (profile as { email?: string }).email?.endsWith("@nstarxinc.com")
        );
      }
      return true;
    },
  },
  pages: {
    signIn: "/login",
  },
});
