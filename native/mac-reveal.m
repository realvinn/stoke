// Only geometry, never titles, pixels, event posting, or a permission request.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <signal.h>
#include <unistd.h>
static volatile sig_atomic_t running = 1;
static void stop(int ignored) { (void)ignored; running = 0; }
int main(void) {
  signal(SIGTERM, stop); signal(SIGINT, stop);
  while (running) {
    @autoreleasepool {
      CFArrayRef raw = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
      if (!raw) { puts("null"); fflush(stdout); }
      else {
        NSMutableArray *frames = [NSMutableArray array];
        for (NSDictionary *window in (__bridge NSArray *)raw) {
          if ([window[(id)kCGWindowLayer] intValue] != 24) continue;
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
