// PERF-5 harness: stands in for next/navigation in the bundle.
export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {} });
export const useSearchParams = () => new URLSearchParams();
export const usePathname = () => "/projects/p1";
export const useParams = () => ({ id: "p1" });
export const redirect = () => {};
export const notFound = () => {};
