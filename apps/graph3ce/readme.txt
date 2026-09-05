--------------------------------------------------
    ______                 __   _____ ____  _____
   / ____/________ _____  / /_ |__  // ___// ___/
  / / __/ ___/ __ `/ __ \/ __ \ /_ </ /   / __/     
 / /_/ / /  / /_/ / /_/ / / / /__/ / /___/ /___  
 \____/_/   \__,_/ .___/_/ /_/____/\____/\____/  
                /_/  [TI-84 Plus CE] Graph3CE 2.0

    ______                 __   _____ ____  ____ 
   / ____/________ _____  / /_ |__  // __ \/ __ \
  / / __/ ___/ __ `/ __ \/ __ \ /_ </ / / / /_/ /
 / /_/ / /  / /_/ / /_/ / / / /__/ / /_/ / ____/ 
 \____/_/   \__,_/ .___/_/ /_/____/_____/_/      
                /_/  [Prizm] Graph3DP 1.1

    by Christopher "Kerm Martian" Mitchell, Ph.D.
    https://z80.me

    v1.0: September 6, 2012
    v2.0: June 20, 2025
    Get it at: https://www.cemetech.net
==================================================

Requirements: TI-84 Plus CE or Casio Prizm

=== Installation (TI-84 Plus CE) ===

Send GRAPH3CE.8xp to your TI-84 Plus CE. You will also need the CE C libraries,
from https://tiny.cc/clibs .

=== Installation (Casio Prizm) ===

Send graph3dp.g3a to the root folder of your Casio Prizm. Simply plug it into your
computer with a miniUSB cable, then drag or copy/paste graph3dp.g3a into the 
calculator's virtual removable drive when it appears. No additional software is
required.

=== Using Graph3CE / Graph3DP ===

    --Menu keys--
      TI-84 Plus CE     Casio Prizm     Function
      [Y=]              [F1]            Z= (enter equations)
      [WINDOW]          [F3]            Change window
      [ZOOM]            [F2]            Zoom
      [Y=][Y=]          [F4]            About and Info
      [TRACE]           [F5]            Trace graph
      [GRAPH]           [F6]            Display graph
      [2nd][MODE]       [EXIT]          Exit. Settings and equations are saved.

    --Equation entry--

    > Up to six equations may be graphed at a time.
    > Use keys, [2nd] (TI-84 Plus CE) or [SHIFT] (Casio Prizm), and [ALPHA]. [ENTER] enables and disables equations.
    > If an equation is malformed, two red exclamation marks (!!) will appear
      next to the equation when you try to graph it.
    > [CLEAR] (TI-84 Plus CE) or [AC/ON] (Casio Prizm) will clear the current equation.
    > Graph3CE/Graph3DP understands the following functions and constants:
              TI-84 Plus CE        Casio Prizm
              ------------------   ------------------
      sin(  = [sin]                [sin]                
      cos(  = [cos]                [cos]                
      tan(  = [tan]                [tan]                
      sinH( = [sin][<][ALPHA][H]   [sin][<][ALPHA][H]   
      cosH( = [cos][<][ALPHA][H]   [cos][<][ALPHA][H]   
      tanH( = [tan][<][ALPHA][H]   [tan][<][ALPHA][H]   
      asin( = [2nd][sin]           [SHIFT][sin]         
      acos( = [2nd][cos]           [SHIFT][cos]         
      atan( = [2nd][tan]           [SHIFT][tan]         
      sqrt( = [2nd][x^2]           [SHIFT][x^2]         
      log(  = [log]                [log]                
      ln(   = [ln]                 [ln]                 
      abs(  = [ab/c]               [MATH]               
      pi    = [2nd][^]             [SHIFT][EXP]
      e^(   = [2nd][ln]            [SHIFT][ln]

    --Graphing equations--

    > Press the [GRAPH] (TI-84 Plus CE) or [F6] (Casio Prizm) key to graph
      currently-selected equations.
    > Use the arrow keys to rotate the graph.
    > Use the [+] and [-] keys to zoom in and out
    > Use [ZOOM] (TI-84 Plus CE) or [F2] (Casio Prizm) to change the graph line color and
      [GRAPH] (TI-84 Plus CE) or [F6] (Casio Prizm) to change the background
      color between white and black
    > Press [TRACE] (TI-84 Plus CE) or [F5] (Casio Prizm) to view a single equation or all enabled
      equations together
    > Press [WINDOW] (TI-84 Plus CE) or [F3] (Casio Prizm) to toggle the axes and the bounding box
      on and off
    > Press [CLEAR] or [2nd][MODE] (TI-84 Plus CE) or [AC/ON] (Casio Prizm to close the menu bar or
      return to the equation editor

    --Tracing equations--

    > Press the [TRACE] (TI-84 Plus CE) or [F5] (Casio Prizm) key to Trace. If you are currently
      rotating a graph, you may need to press [Y=] (TI-84 Plus CE) or [F1] (Casio Prizm) to make the
      menu pop up first.
    > In trace mode, [TRACE] (TI-84 Plus CE) or [F5] (Casio Prizm) toggles which equation you're tracing
    > The arrow keys move the trace cursor over the graphed equation
    > For clarity, graphs are traced from a top-down view.
    > Press [CLEAR] to return to the equation editor

    --Zooming--
    > Press [+] or [-] on the graph/trace views, or press [ZOOM] (TI-84 Plus CE) or [F2] (Casio Prizm)
    > From the zoom menu, use the arrows to select an option and press [ENTER]
    > Zoom Default restores XMin=-10, XMax=10, Ymin=-10, Ymax=10, XSteps=YSteps=21

    --Window Settings--
    > The Window defines the extents of the graph and the granularity of the mesh
    > XSteps is the number of contour lines drawn between YMin and YMax, while
      YSteps is the number of contour lines drawn between XMin and XMax.
    > XSteps and YSteps must be at least 2. The larger the number, the denser and
      more accurate the mesh, but the slower the graph is to rotate.

=== Known issues ===
[None]
Disclaimer: This is a "gold" release. It is believed to be stable, but
            may crash your TI-84 Plus CE / Prizm and force it to restart. It should
            not brick or otherwise break your calculator, but the author disclaims
            any and all responsibility if it does. In addition, no warranty express
            or implied is given to the fitness of this add-in for any particular
            purpose, and the author and any associated parties or groups are
            not responsible for incorrect examination/test questions, numerical
            mistakes, or miscalculations of any sort stemming from this use of
            this Add-In.


=== Feedback and Help === 
Post questions in http://cemete.ch/t8147 (Casio Prizm) or http://cemete.ch/t19963 (TI-84 Plus CE),
or start your own topic on the Cemetech forum, https://www.cemetech.net/forum .

Info and more Prizm and TI-84 Plus CE projects: https://www.cemetech.net
My personal website and blog: https://z80.me
