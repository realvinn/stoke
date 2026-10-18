// Only geometry, never titles, pixels, event posting, or a permission request.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <signal.h>
#include <unistd.h>
static volatile sig_atomic_t running = 1;
static void stop(int ignored) { (void)ignored; running = 0; }
int main(void) {
  signal(SIGTERM, stop); signal(SIGINT, stop);
  // AppKit's full-screen title strip is a separate layer-0 window owned by
  // Stoke. Layer 24 contains only the menu bar (30pt here), not the strip
  // underneath it (32pt here). Sampling the menu alone leaves tabs covered.
  const pid_t owner = getppid();
  while (running) {
    @autoreleasepool {
      CFArrayRef raw = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
      if (!raw) { puts("null"); fflush(stdout); }
      else {
        NSMutableArray *frames = [NSMutableArray array];
        for (NSDictionary *window in (__bridge NSArray *)raw) {
          const int layer = [window[(id)kCGWindowLayer] intValue];
          if (layer != 24 && !(layer == 0 && [window[(id)kCGWindowOwnerPID] intValue] == owner)) continue;
          CGRect bounds;
          if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
          if (bounds.size.width < 300 || bounds.size.height < 16 || bounds.size.height > 160) continue;
          [frames addObject:@{ @"x": @(bounds.origin.x), @"y": @(bounds.origin.y), @"width": @(bounds.size.width), @"height": @(bounds.size.height), @"onscreen": @([window[(id)kCGWindowIsOnscreen] boolValue]) }];
        }
        CFRelease(raw);
        NSData *data = [NSJSONSerialization dataWithJSONObject:frames options:0 error:nil];
        fwrite(data.bytes, 1, data.length, stdout); putchar('\n'); fflush(stdout);
      }
    }
    usleep(33333);
  }
  return 0;
}
